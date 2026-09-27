# Observability Guide

This document is the operator reference for monitoring WorkloadGovernor in production. It covers the CloudWatch dashboard, alarm thresholds, health check endpoints, and how to extend the setup with new metrics.

---

## Table of Contents

- [CloudWatch Dashboard](#cloudwatch-dashboard)
- [Panel Inventory](#panel-inventory)
- [Alarm Thresholds](#alarm-thresholds)
- [Health Check Endpoints](#health-check-endpoints)
- [Logs Insights Saved Queries](#logs-insights-saved-queries)
- [Adding a New Metric](#adding-a-new-metric)

---

## CloudWatch Dashboard

The operational dashboard is defined in [`infra/logs_and_alarms.tf`](../infra/logs_and_alarms.tf) as the `aws_cloudwatch_dashboard.service_dashboard` resource.

### Accessing the dashboard

The dashboard name is `<service_name>-dashboard` (e.g. `workload-governor-dashboard`). Open it in the AWS Console at:

```
https://console.aws.amazon.com/cloudwatch/home?region=<AWS_REGION>#dashboards:name=<SERVICE_NAME>-dashboard
```

Replace `<AWS_REGION>` with your deployment region (e.g. `us-east-1`) and `<SERVICE_NAME>` with the value of the `service_name` Terraform variable (default: `workload-governor`).

**Example (us-east-1, default service name):**

```
https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:name=workload-governor-dashboard
```

The dashboard ARN and name are also exported as Terraform outputs:

```bash
terraform output operational_dashboard_name
terraform output operational_dashboard_arn
```

---

## Panel Inventory

The dashboard contains six widgets. All metric panels use a 60-second period unless noted.

| # | Widget title | Type | Metric(s) | Stat | Period | What it indicates |
|---|---|---|---|---|---|---|
| 1 | *(title bar)* | Text | — | — | — | Service name header |
| 2 | High Error Rate | Alarm status | `ErrorCount` (`<service>/Application`) | Sum | 60 s | Fires when > 10 ERROR log lines per minute for 2 consecutive periods |
| 3 | HTTP 5xx Rate | Alarm status | `Http5xxCount` (`<service>/Application`) | Sum | 60 s | Fires when > 5 HTTP 5xx responses per minute for 2 consecutive periods |
| 4 | Soroban RPC Failover | Alarm status | `SorobanRpcFailover` (`<service>/Application`) | Sum | 60 s | Fires on any Soroban RPC failover event |
| 5 | Application Error Count | Time series | `ErrorCount`, `Http5xxCount`, `SorobanRpcFailover` | Sum | 60 s | Trend of all three error signals on one graph |
| 6 | ECS CPU & Memory Utilization | Time series | `AWS/ECS CPUUtilization`, `MemoryUtilization` | Average | 60 s | ECS task resource usage (rendered only when `ecs_cluster_name` variable is set) |
| 7 | RDS Database Connections | Time series | `AWS/RDS DatabaseConnections` | Average | 60 s | Active RDS connections (rendered only when `rds_instance_identifier` variable is set) |

> **Panels 6 and 7** are conditionally rendered. If the Terraform variables `ecs_cluster_name` or `rds_instance_identifier` are empty strings, the corresponding metric arrays are empty and CloudWatch displays a blank widget. Set the variables to populate the panels:
>
> ```hcl
> module "logs_and_alarms" {
>   ecs_cluster_name      = "workload-governor-prod"
>   rds_instance_identifier = "workload-governor-prod-db"
> }
> ```

---

## Alarm Thresholds

All alarms publish to the `devops-alerts` SNS topic. Subscribers (email and optional PagerDuty/Slack) are configured via the `alarm_email`, `pagerduty_https_endpoint`, and `slack_webhook_url` Terraform variables in `infra/logs_and_alarms.tf` and `infra/uptime.tf`.

### Application alarms (`infra/logs_and_alarms.tf`)

| Alarm name | Metric | Threshold | Evaluation periods | Period | Treat missing data | SNS topic |
|---|---|---|---|---|---|---|
| `<service>-high-error-rate` | `ErrorCount` (Sum) | ≥ 10 per minute | 2 consecutive | 60 s | breaching | `devops-alerts` |
| `<service>-high-5xx-rate` | `Http5xxCount` (Sum) | ≥ 5 per minute | 2 consecutive | 60 s | breaching | `devops-alerts` |
| `<service>-soroban-rpc-failover` | `SorobanRpcFailover` (Sum) | ≥ 1 | 1 | 60 s | breaching | `devops-alerts` |

### Uptime alarms (`infra/uptime.tf`)

These alarms use Route 53 health-check metrics published in `us-east-1` regardless of your deployment region.

| Alarm name | Health check | Metric | Threshold | Evaluation periods | Period | What it detects |
|---|---|---|---|---|---|---|
| `<service>-backend-health-down` | `GET /api/health` (10 s interval) | `HealthCheckStatus` (Min) | < 1 | 2 consecutive | 60 s | Backend unreachable after 2 consecutive failures |
| `<service>-backend-availability-low` | `GET /api/health` | `HealthCheckPercentageHealthy` (Avg) | < 99.5 % | 1 | 3 600 s (1 h) | Backend SLA breach risk over 1-hour window |
| `<service>-frontend-down` | ALB root `/` (30 s interval) | `HealthCheckStatus` (Min) | < 1 | 2 consecutive | 60 s | Frontend unreachable after 2 consecutive failures |
| `<service>-frontend-availability-low` | ALB root `/` | `HealthCheckPercentageHealthy` (Avg) | < 99.5 % | 1 | 3 600 s (1 h) | Frontend SLA breach risk over 1-hour window |
| `<service>-horizon-network-degraded` | `GET /api/health/network` (30 s interval) | `HealthCheckStatus` (Min) | < 1 | 2 consecutive | 60 s | Degraded Horizon/Soroban connectivity |

**SLA target:** 99.5 % monthly uptime. Alerts fire on two consecutive failures; availability alarms fire when the 1-hour average drops below 99.5 %.

**Who is notified:** All alarms route to the `devops-alerts` SNS topic. Configure the topic's subscribers in Terraform:

```hcl
variable "alarm_email"              { default = "oncall@yourorg.com" }
variable "slack_webhook_url"        { default = "https://hooks.slack.com/..." }
variable "pagerduty_https_endpoint" { default = "https://events.pagerduty.com/..." }
```

---

## Health Check Endpoints

Three endpoints are monitored by Route 53 health checks and surfaced on the dashboard.

### `GET /api/health`

Primary backend health check. Checked every **10 seconds** by Route 53.

**Request**

```http
GET /api/health HTTP/1.1
Host: api.example.com
```

**Response — all healthy (HTTP 200)**

```json
{
  "status": "healthy",
  "dependencies": [
    { "name": "postgres",    "status": "healthy", "latency_ms": 3  },
    { "name": "redis",       "status": "healthy", "latency_ms": 1  },
    { "name": "soroban_rpc", "status": "healthy", "latency_ms": 42 },
    { "name": "horizon",     "status": "healthy", "latency_ms": 87 },
    { "name": "github",      "status": "healthy", "latency_ms": 120}
  ]
}
```

**Response — critical dependency down (HTTP 503)**

```json
{
  "status": "unhealthy",
  "dependencies": [
    { "name": "postgres",    "status": "unhealthy", "latency_ms": 2001 },
    { "name": "redis",       "status": "healthy",   "latency_ms": 1    },
    { "name": "soroban_rpc", "status": "healthy",   "latency_ms": 38   },
    { "name": "horizon",     "status": "healthy",   "latency_ms": 90   },
    { "name": "github",      "status": "healthy",   "latency_ms": 115  }
  ]
}
```

**Status semantics**

| `status` | HTTP code | Meaning |
|---|---|---|
| `healthy` | 200 | All dependencies reachable |
| `degraded` | 200 | At least one non-critical dependency unreachable |
| `unhealthy` | 503 | At least one critical dependency (`postgres` or `soroban_rpc`) unreachable |

Critical dependencies are `postgres` and `soroban_rpc`. All checks have a 2-second timeout. Source: [`backend/src/health.ts`](../backend/src/health.ts).

---

### `GET /api/health/network`

Horizon / Soroban network connectivity check. Checked every **30 seconds** by Route 53.

**Request**

```http
GET /api/health/network HTTP/1.1
Host: api.example.com
```

**Response — Horizon reachable (HTTP 200)**

```json
{
  "status": "healthy",
  "network": "testnet",
  "horizon_url": "https://horizon-testnet.stellar.org",
  "latest_ledger": 52441190
}
```

**Response — Horizon degraded (HTTP 503)**

```json
{
  "status": "degraded",
  "network": "testnet",
  "horizon_url": "https://horizon-testnet.stellar.org",
  "error": "Horizon /fee_stats returned 503"
}
```

Route 53 treats any non-2xx response as a failure. Two consecutive failures trigger the `<service>-horizon-network-degraded` alarm.

---

### ALB root `/`

Frontend availability check. Checked every **30 seconds** by Route 53 against the ALB DNS name.

**Request**

```http
GET / HTTP/1.1
Host: example.com
```

**Expected response:** HTTP 200 with the frontend HTML shell. Any non-200 response (including 5xx from the ALB) is counted as a failure.

---

## Logs Insights Saved Queries

Three saved Logs Insights queries are defined in [`infra/logs_and_alarms.tf`](../infra/logs_and_alarms.tf) and target the `/ecs/<service_name>` log group. Open them in the AWS Console under **CloudWatch → Logs Insights → Saved queries**.

| Query name | Purpose | Key fields |
|---|---|---|
| `<service>-error-rate` | Count errors per path per hour, sorted by frequency | `path`, `status`, `correlationId` |
| `<service>-slow-requests` | p95 latency per path, sorted by slowest | `path`, `duration`, p95 stat |
| `<service>-contract-submission-failures` | Count Soroban RPC failures per hour | `correlationId`, `error`, `path` |

**Log format** (pino JSON, `src/logger.ts`):

```json
{ "correlationId": "abc-123", "method": "POST", "path": "/api/transactions/apply",
  "status": 200, "duration": 84, "timestamp": "2026-09-27T23:00:00.000Z" }
```

---

## Adding a New Metric

Follow these steps when you need to add a new observable signal to the dashboard. Include both the Terraform change and this doc update in the **same PR**.

### 1. Add a metric filter (if the signal comes from logs)

In `infra/logs_and_alarms.tf`, add a new `aws_cloudwatch_log_metric_filter` block:

```hcl
resource "aws_cloudwatch_log_metric_filter" "my_new_signal" {
  name           = "${var.service_name}-my-new-signal"
  pattern        = "\"my signal pattern\""          # CloudWatch filter syntax
  log_group_name = aws_cloudwatch_log_group.ecs.name

  metric_transformation {
    name          = "MyNewSignal"
    namespace     = "${var.service_name}/Application"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}
```

Skip this step if the signal is a native AWS metric (e.g. `AWS/ECS`, `AWS/RDS`).

### 2. Add an alarm (optional)

```hcl
resource "aws_cloudwatch_metric_alarm" "my_new_signal_alarm" {
  alarm_name          = "${var.service_name}-my-new-signal"
  alarm_description   = "Describe what this alarm detects"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "MyNewSignal"
  namespace           = "${var.service_name}/Application"
  period              = 60
  statistic           = "Sum"
  threshold           = 5
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.devops_alerts.arn]
  ok_actions          = [aws_sns_topic.devops_alerts.arn]
}
```

### 3. Add a dashboard widget

Inside the `widgets` array of `aws_cloudwatch_dashboard.service_dashboard`, add a new metric widget. Assign it the next available `y` coordinate (each row is 6 units high):

```hcl
{
  type   = "metric"
  x      = 0
  y      = 16          # next available row
  width  = 12
  height = 6
  properties = {
    title  = "My New Signal"
    view   = "timeSeries"
    period = 60
    metrics = [
      ["${var.service_name}/Application", "MyNewSignal", { stat = "Sum" }]
    ]
  }
},
```

### 4. Update this document

Add a row to the [Panel Inventory](#panel-inventory) table and, if you added an alarm, a row to the [Alarm Thresholds](#alarm-thresholds) table.

### 5. Apply and verify

```bash
# Preview changes
terraform plan -var="service_name=workload-governor"

# Apply
terraform apply -var="service_name=workload-governor"

# Confirm the dashboard updated
terraform output operational_dashboard_name
```

Open the dashboard URL and confirm the new panel is visible.

---

## Status Dashboard Links

| Check | Endpoint | Dashboard |
|---|---|---|
| Backend health | `GET /api/health` | [Route 53 Health Checks](https://console.aws.amazon.com/route53/healthchecks/home) |
| Frontend | ALB root `/` | [Route 53 Health Checks](https://console.aws.amazon.com/route53/healthchecks/home) |
| Horizon network | `GET /api/health/network` | [Route 53 Health Checks](https://console.aws.amazon.com/route53/healthchecks/home) |
| Operational metrics | All panels | [CloudWatch Dashboard](https://console.aws.amazon.com/cloudwatch/home#dashboards) |

See the [README Status table](../README.md#status) for the same summary.
