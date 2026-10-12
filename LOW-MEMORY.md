# Low-memory production deployment

Use this repository's Dockerfile and one running replica. In Dokploy Advanced > Resources set Memory Limit to **218103808 bytes (208 MiB)**, then redeploy. The frontend budget is 256 MiB; both containers total 464 MiB (486539264 bytes), below 500 MB.

The runner sets NODE_OPTIONS=--max-old-space-size=128 --max-semi-space-size=4 and UV_THREADPOOL_SIZE=2. Update any existing Dokploy NODE_OPTIONS override to match. npm start also sets these heap limits. Build memory and the database are outside the runtime budget.

Keep existing secrets, DATABASE_URL, network and persistent uploads/backups volumes. Leave STARTUP_MAINTENANCE_ENABLED and BACKGROUND_TASKS_ENABLED at their defaults in production. Disabling them was only for the isolated benchmark.

Backups stream bounded batches to disk, image restoration loads one missing image at a time, order sync runs without overlaps, and public pricing cache misses share one query. Run npm run test:memory after building.

Local Windows/Node 24 testing with the frontend handled 1050 requests at concurrency 20 while streaming a synthetic 256 MiB backup: combined peak process RSS was about 338 MB. Docker/Linux Node 22 was not available for local container measurement. Verify actual container usage after deployment; large backup restoration/provider imports and production cron load need their own monitoring.

Dokploy resource values are raw bytes: https://docs.dokploy.com/docs/core/applications/advanced
