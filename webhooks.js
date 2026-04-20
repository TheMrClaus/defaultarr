const logger = require("./logger")

module.exports = (app, provider, orchestrator) => {
    // Legacy Plex/Tautulli route
    app.post("/webhook", async (req, res) => {
        try {
            if (provider.name !== "plex") {
                return res
                    .status(410)
                    .send("This server is configured for a non-Plex provider. Use /webhook/emby instead.")
            }
            logger.info("Tautulli webhook received. Processing...")
            const parsed = await provider.parseWebhook(req.body)
            if (!parsed) return res.status(400).send("Invalid or unsupported payload")
            const result = await orchestrator.processWebhookItem(parsed)
            logger.info("Tautulli webhook finished")
            return res.status(result.status).send(result.message)
        } catch (error) {
            logger.error(`Error processing webhook: ${error.message}`)
            return res.status(500).send("Error processing webhook")
        }
    })

    app.post("/webhook/emby", async (req, res) => {
        try {
            if (provider.name !== "emby") {
                return res
                    .status(410)
                    .send("This server is configured for a non-Emby provider. Use /webhook instead.")
            }
            logger.info("Emby webhook received. Processing...")
            const parsed = await provider.parseWebhook(req.body)
            if (!parsed) return res.status(200).send("Event not relevant")
            const result = await orchestrator.processWebhookItem(parsed)
            logger.info("Emby webhook finished")
            return res.status(result.status).send(result.message)
        } catch (error) {
            logger.error(`Error processing Emby webhook: ${error.message}`)
            return res.status(500).send("Error processing webhook")
        }
    })
}
