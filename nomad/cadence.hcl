# T17: no default. CI always passes the tag it built; by hand, name the release on purpose
# (`nomad job history cadence` lists the tags that ran), never September's first image.
variable "image_tag" {
  type = string
}

# T04 (held back): the registry login stays a job variable until worker-5 pulls with its own
# pull-only Harbor robot account (DEPLOY.md, "Registry credentials"); then delete these two
# variables and both auth blocks.
variable "harbor_username" {
  type    = string
  default = "admin"
}

variable "harbor_password" {
  type = string
}

locals {
  registry = "h4rb0r.pmx.acumen-strategy.com"
  image    = "${local.registry}/sales-cadence/app:${var.image_tag}"
}

job "cadence" {
  datacenters = ["acumen-dc"]
  type        = "service"

  constraint {
    attribute = "${attr.unique.hostname}"
    value     = "worker-5"
  }

  # A bad image should undo itself. Without auto_revert a deploy that fails its
  # health check simply stays broken, and Cadence writes to the production CRM.
  # The deadlines are generous because the web task applies Prisma migrations
  # before it serves anything: a release with a slow migration is not a failure.
  # T14: they sit above the checks' 15-minute grace, so a long migration is not
  # cut off part-way by a health-check restart.
  update {
    max_parallel      = 1
    health_check      = "checks"
    min_healthy_time  = "30s"
    healthy_deadline  = "20m"
    progress_deadline = "25m"
    auto_revert       = true
  }

  group "cadence" {
    count = 1

    # Postgres or Twenty being briefly unreachable is ridden out by the retries
    # inside the entrypoint and five restarts 30 s apart. T12: after that the
    # allocation is marked failed (visible in `nomad job status`, and a deploy
    # rolls back) and Nomad reschedules it with a growing delay, instead of a
    # task that crashes on every start looping silently for ever.
    restart {
      attempts = 5
      interval = "10m"
      delay    = "30s"
      mode     = "fail"
    }

    network {
      port "http" {
        static       = 3100
        to           = 3000
        host_network = "default"
      }
    }

    # ------------------------------------------------------------------- web
    # Applies migrations and the (idempotent) seed on start, then serves Next.
    task "web" {
      driver = "docker"
      consul {}

      config {
        image   = local.image
        ports   = ["http"]
        command = "sh"
        args    = ["docker/entrypoint.sh", "web"]
        # tini as PID 1: next and prisma both spawn children, and npm does not
        # reap them.
        init        = true
        dns_servers = ["172.17.0.1", "8.8.8.8"]
        auth {
          server_address = local.registry
          username       = var.harbor_username
          password       = var.harbor_password
        }
      }

      # T06: CADENCE_DRY_RUN comes from the Nomad variable (default false): setting it to true there
      # restarts both tasks with every CRM write stopped, no redeploy (DEPLOY.md, "Stop all CRM writes").
      template {
        destination = "secrets/cadence.env"
        env         = true
        data        = <<EOH
{{- with nomadVar "nomad/jobs/cadence" }}
DATABASE_URL={{ .DATABASE_URL }}
TWENTY_API_KEY={{ .TWENTY_API_KEY }}
TWENTY_WEBHOOK_SECRET={{ .TWENTY_WEBHOOK_SECRET }}
{{- if .ADMIN_EMAIL }}
ADMIN_EMAIL={{ .ADMIN_EMAIL }}
{{- end }}
{{- if .ADMIN_PASSWORD }}
ADMIN_PASSWORD={{ .ADMIN_PASSWORD }}
{{- end }}
{{- if .BELLWETHER_API_KEY }}
BELLWETHER_API_KEY={{ .BELLWETHER_API_KEY }}
{{- end }}
{{- if .BELLWETHER_API_KEY_PREVIOUS }}
BELLWETHER_API_KEY_PREVIOUS={{ .BELLWETHER_API_KEY_PREVIOUS }}
{{- end }}
{{- if .TWILIO_ACCOUNT_SID }}
TWILIO_ACCOUNT_SID={{ .TWILIO_ACCOUNT_SID }}
TWILIO_API_KEY_SID={{ .TWILIO_API_KEY_SID }}
TWILIO_API_KEY_SECRET={{ .TWILIO_API_KEY_SECRET }}
{{- end }}
{{- if .CADENCE_DRY_RUN }}
CADENCE_DRY_RUN={{ .CADENCE_DRY_RUN }}
{{- else }}
CADENCE_DRY_RUN=false
{{- end }}
{{- if .PASSWORD_SIGN_IN }}
PASSWORD_SIGN_IN={{ .PASSWORD_SIGN_IN }}
{{- end }}
{{- if .H00KS_API_TOKEN }}
H00KS_API_TOKEN={{ .H00KS_API_TOKEN }}
{{- end }}
{{- end }}
NODE_ENV=production
DATABASE_CONNECTION_LIMIT=6
DATABASE_POOL_TIMEOUT=20
NODE_OPTIONS=--max-old-space-size=512
TWENTY_MODE=graphql
TWENTY_API_URL=https://app.tw3ntycrm.acm.acumen-strategy.com
APP_URL=https://cadence.pmx.acumen-strategy.com
COOKIE_SECURE=true
SEED_ON_START=true
SEED_PROFILE=core
GRAPH_MAIL_ENABLED=false
EOH
      }

      resources {
        cpu        = 1000
        memory     = 1024
        memory_max = 2048
      }

      service {
        name = "cadence"
        port = "http"
        tags = ["cadence", "web"]

        # T11: /api/health answers 200 only while the database answers too.
        check {
          name     = "cadence-http"
          type     = "http"
          path     = "/api/health"
          interval = "30s"
          timeout  = "10s"

          # The grace covers migrations plus the Next boot; restarting inside
          # that window would only interrupt a migration midway (T14).
          check_restart {
            limit = 5
            grace = "900s"
          }
        }
      }
    }

    # ---------------------------------------------------------------- worker
    # Continuous Twenty sync, the step scheduler and the nightly reconcile.
    # Shares the image and the database. T37: both tasks run `prisma migrate
    # deploy` on start; Prisma's advisory lock lets one apply the migrations
    # while the other waits (the entrypoint says so). Only the web seeds
    # (SEED_ON_START is false here).
    task "worker" {
      driver = "docker"
      consul {}
      # P14: the worker waits up to 20 s for the pass in progress before it exits; the default 5 s kill cut it mid-pass.
      kill_timeout = "30s"

      # T10: time to finish the current pass (a CRM move, the nightly reconcile)
      # after the stop signal before Nomad kills it. The Nomad client caps this
      # at its own max_kill_timeout (30 s unless raised in the client config).
      kill_timeout = "5m"

      config {
        image       = local.image
        command     = "sh"
        args        = ["docker/entrypoint.sh", "worker"]
        init        = true
        dns_servers = ["172.17.0.1", "8.8.8.8"]
        auth {
          server_address = local.registry
          username       = var.harbor_username
          password       = var.harbor_password
        }
      }

      template {
        destination = "secrets/worker.env"
        env         = true
        data        = <<EOH
{{- with nomadVar "nomad/jobs/cadence" }}
DATABASE_URL={{ .DATABASE_URL }}
TWENTY_API_KEY={{ .TWENTY_API_KEY }}
TWENTY_WEBHOOK_SECRET={{ .TWENTY_WEBHOOK_SECRET }}
{{- if .TWILIO_ACCOUNT_SID }}
TWILIO_ACCOUNT_SID={{ .TWILIO_ACCOUNT_SID }}
TWILIO_API_KEY_SID={{ .TWILIO_API_KEY_SID }}
TWILIO_API_KEY_SECRET={{ .TWILIO_API_KEY_SECRET }}
{{- end }}
{{- if .CADENCE_DRY_RUN }}
CADENCE_DRY_RUN={{ .CADENCE_DRY_RUN }}
{{- else }}
CADENCE_DRY_RUN=false
{{- end }}
{{- if .H00KS_API_TOKEN }}
H00KS_API_TOKEN={{ .H00KS_API_TOKEN }}
{{- end }}
{{- end }}
NODE_ENV=production
DATABASE_CONNECTION_LIMIT=4
DATABASE_POOL_TIMEOUT=20
NODE_OPTIONS=--max-old-space-size=320
TWENTY_MODE=graphql
TWENTY_API_URL=https://app.tw3ntycrm.acm.acumen-strategy.com
APP_URL=https://cadence.pmx.acumen-strategy.com
SEED_ON_START=false
GRAPH_MAIL_ENABLED=false
CRM_SYNC_SECONDS=300
WORKER_TICK_SECONDS=60
RECONCILE_HOUR=2
EOH
      }

      resources {
        cpu        = 500
        memory     = 640
        memory_max = 1024
      }

      # P01: the worker has no port of its own. Each pass stamps a heartbeat in the database and
      # the web answers /api/health/worker with 503 once it is 20 minutes old (dead, hung or never
      # started), so Nomad restarts the worker and a deploy whose worker never runs is not healthy.
      service {
        name = "cadence-worker"
        port = "http"
        tags = ["cadence", "worker"]

        check {
          name     = "cadence-worker-heartbeat"
          type     = "http"
          path     = "/api/health/worker"
          interval = "60s"
          timeout  = "10s"

          # 900 s like the web: the worker waits while the web applies migrations.
          check_restart {
            limit = 3
            grace = "900s"
          }
        }
      }
    }
  }
}
