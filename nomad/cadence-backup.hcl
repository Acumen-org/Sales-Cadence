# T02: nightly backup of Cadence's Postgres database (scripts/backup-db.sh).
#
# Submit from the repository root (the script is read in at submit time):
#   nomad job run -var="backup_host_path=/srv/backups/cadence" nomad/cadence-backup.hcl
# Run one now:   nomad job periodic force cadence-db-backup
# Restore:       DEPLOY.md, "Restore the database".
#
# The destination is a directory on the client, mounted into the container. It should be a mount
# of storage that is not the database server's own disk (NFS, a backup share), or a backup taken
# here is lost with the server it protects. The Nomad client must allow docker volume mounts
# (plugin "docker" { config { volumes { enabled = true } } }).
#
# The connection string is the Nomad variable nomad/jobs/cadence-db-backup (item DATABASE_URL): a
# job reads only its own variables. Best a role that can only read (pg_read_all_data).

variable "backup_host_path" {
  type        = string
  description = "Directory on the Nomad client that receives the dumps."
}

variable "retention_days" {
  type    = number
  default = 14
}

variable "postgres_image" {
  type    = string
  # Same major version as production (Postgres 18); pg_dump must not be older than the server.
  default = "postgres:18-alpine"
}

job "cadence-db-backup" {
  datacenters = ["acumen-dc"]
  type        = "batch"

  constraint {
    attribute = "${attr.unique.hostname}"
    value     = "worker-5"
  }

  periodic {
    crons            = ["30 3 * * *"]
    time_zone        = "America/New_York"
    prohibit_overlap = true
  }

  group "backup" {
    count = 1

    restart {
      attempts = 2
      interval = "30m"
      delay    = "2m"
      mode     = "fail"
    }

    task "pg-dump" {
      driver = "docker"

      config {
        image   = var.postgres_image
        command = "sh"
        args    = ["/local/backup-db.sh"]
        volumes = ["${var.backup_host_path}:/backups"]
      }

      template {
        destination = "local/backup-db.sh"
        perms       = "755"
        data        = file("scripts/backup-db.sh")
        # The script holds "${...}" shell expansions; keep the template engine away from them.
        left_delimiter  = "[[["
        right_delimiter = "]]]"
      }

      template {
        destination = "secrets/backup.env"
        env         = true
        data        = <<EOH
{{- with nomadVar "nomad/jobs/cadence-db-backup" }}
DATABASE_URL={{ .DATABASE_URL }}
{{- end }}
BACKUP_DIR=/backups
BACKUP_RETENTION_DAYS=${var.retention_days}
EOH
      }

      resources {
        cpu    = 300
        memory = 256
      }
    }
  }
}
