variable "image_tag" {
  type    = string
  default = "prod-v1.0.0-initial"
}

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
  update {
    max_parallel      = 1
    health_check      = "checks"
    min_healthy_time  = "30s"
    healthy_deadline  = "10m"
    progress_deadline = "15m"
    auto_revert       = true
  }

  group "cadence" {
    count = 1

    # Postgres or Twenty being briefly unreachable should not put the group in
    # a crash loop; back off and keep trying rather than failing the alloc.
    restart {
      attempts = 5
      interval = "10m"
      delay    = "30s"
      mode     = "delay"
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

      template {
        destination = "secrets/cadence.env"
        env         = true
        data        = <<EOH
{{- with nomadVar "nomad/jobs/cadence" }}
DATABASE_URL={{ .DATABASE_URL }}?connection_limit=6&pool_timeout=20
SESSION_SECRET={{ .SESSION_SECRET }}
TWENTY_API_KEY={{ .TWENTY_API_KEY }}
TWENTY_WEBHOOK_SECRET={{ .TWENTY_WEBHOOK_SECRET }}
ADMIN_EMAIL={{ .ADMIN_EMAIL }}
ADMIN_PASSWORD={{ .ADMIN_PASSWORD }}
{{- end }}
NODE_ENV=production
NODE_OPTIONS=--max-old-space-size=512
TWENTY_MODE=graphql
TWENTY_API_URL=https://app.tw3ntycrm.acm.acumen-strategy.com
APP_URL=https://cadence.pmx.acumen-strategy.com
COOKIE_SECURE=true
SEED_ON_START=true
SEED_PROFILE=core
CADENCE_DRY_RUN=false
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

        check {
          name     = "cadence-http"
          type     = "http"
          path     = "/login"
          interval = "30s"
          timeout  = "10s"

          # The grace covers migrations plus the Next boot; restarting inside
          # that window would only interrupt a migration midway.
          check_restart {
            limit = 5
            grace = "300s"
          }
        }
      }
    }

    # ---------------------------------------------------------------- worker
    # Continuous Twenty sync, the step scheduler and the nightly reconcile.
    # Shares the image and the database; the web task owns schema and seeding,
    # so SEED_ON_START is false here and the two never race on start.
    task "worker" {
      driver = "docker"
      consul {}

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
DATABASE_URL={{ .DATABASE_URL }}?connection_limit=4&pool_timeout=20
SESSION_SECRET={{ .SESSION_SECRET }}
TWENTY_API_KEY={{ .TWENTY_API_KEY }}
TWENTY_WEBHOOK_SECRET={{ .TWENTY_WEBHOOK_SECRET }}
{{- end }}
NODE_ENV=production
NODE_OPTIONS=--max-old-space-size=320
TWENTY_MODE=graphql
TWENTY_API_URL=https://app.tw3ntycrm.acm.acumen-strategy.com
APP_URL=https://cadence.pmx.acumen-strategy.com
SEED_ON_START=false
CADENCE_DRY_RUN=false
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
    }
  }
}
