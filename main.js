const express = require("express")
const logger = require("./logger")
const loadAndValidateYAML = require("./configBuilder")
const createProvider = require("./providers")
const createOrchestrator = require("./orchestrator")
const mountWebhooks = require("./webhooks")

const config = loadAndValidateYAML()
const timestampsFile = process.argv[4] || "./last_run_timestamps.json"

const app = express()
app.use(express.json())

const provider = createProvider(config)
const orchestrator = createOrchestrator(provider, config, { timestampsFile })

mountWebhooks(app, provider, orchestrator)

process.on("uncaughtException", (error) => logger.error(`Uncaught exception: ${error.message}`))
process.on("unhandledRejection", (reason) => logger.error(`Unhandled rejection: ${reason}`))

const PORT = process.env.PORT || 3184
app.listen(PORT, async () => {
    logger.info(`Server is running on port ${PORT}`)
    try {
        await orchestrator.init()

        if (config.dry_run) await orchestrator.performDryRun()
        else if (config.partial_run_on_start) await orchestrator.performPartialRun()
        else if (config.clean_run_on_start) await orchestrator.performPartialRun(config.clean_run_on_start)

        orchestrator.setupCron()
    } catch (error) {
        logger.error(`Error initializing the application: ${error.message}`)
        process.exit(1)
    }
})
