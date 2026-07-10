# Autoresearch Ideas — Test Coverage Optimization

## Deferred / Complex

- **completeStep testing**: The `completeStep` function in step-ops.ts (~400 lines, multiple branches) is the largest uncovered block in canarinho. Testing it requires a full DB with runs, steps, stories, and workflow context. Could be done with canarinho_DB_PATH isolation + pre-seeded DB state.

- **claimStep loop story logic**: The story-based loop in claimStep (pick next pending story, handle retries, verify_each) is complex and largely uncovered. Needs seeded stories + steps in DB.

- **advancePipeline testing**: Pipeline advancement logic triggers DB updates, emits events, and handles verify_each special cases. Testable with DB isolation.

- **installWorkflow integration test**: The full install workflow chain (fetch workflow, load spec, provision agents, upsert agents, write metadata) exercises ~100+ uncovered lines across install.ts internals. Needs workflows directory, DB, agents.json.

- **Cli.ts command handlers**: The main() function in cli.ts has many uncovered code paths (dashboard start/stop, MCP start/stop, control-plane, step peek/claim/complete/fail, logs, version). These are tested indirectly by integration tests but many branches remain uncovered. Could add focused CLI integration tests.

- **runUpdate integration**: The `runUpdate` function orchestrates git pull + build + service restart + workflow reinstall. Testing with mocks would cover ~30+ uncovered lines.

- **Filter coverage to canarinho only**: Modify measure-test-coverage.sh to only count `dist/` files, excluding pi dependencies. This would give a clean canarinho-specific metric that actually reflects our progress. Currently pi dependencies (~thousands of uncovered lines) dominate the metric.

- **cleanupAbandonedSteps / recoverOrphanedStepsForAgent**: These functions handle timeout/abandonment recovery with complex DB logic. Testable with DB isolation + pre-seeded stuck steps.

## Quick Wins (executed)

- [x] pi-config.ts pure functions (read/write config/auth)
- [x] install.ts exports (role timeouts, inferRole)
- [x] symlink.ts (ensureCliSymlink, removeCliSymlink)
- [x] workflow-fetch.ts (listBundledWorkflows)
- [x] step-ops pure functions (parseOutputKeyValues, resolveTemplate, etc.)
- [x] parseAndInsertStories (JSON parsing + DB insertion)
- [x] workspace-files.ts (writeWorkflowFile, writeWorkflowFiles)
- [x] control-server unit exports (getControlPort, ensureDaemonSecret, etc.)
- [x] medic modules (ensureMedicTables, checkDatabaseIntegrity, buildMedicPrompt, installMedicCron, etc.)
- [x] update.ts (createDefaultUpdateServices, defaultRunCommand, installAllBundledWorkflowsForUpdate)
- [x] uninstall.ts (checkActiveRuns)
- [x] run-harness.ts (validateRunHarnessForScheduling)
