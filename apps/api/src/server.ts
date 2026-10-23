import { app } from "./app.js";
import { config } from "./config.js";

app.listen(config.PORT, "127.0.0.1", () => {
  console.info(JSON.stringify({ level: "info", event: "api.started", port: config.PORT, environment: config.NODE_ENV }));
});
