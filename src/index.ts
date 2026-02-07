import { env } from "./env.js";
import { createServer } from "./server.js";

const start = async () => {
  const app = await createServer();
  try {
    await app.listen({ port: env.port, host: "0.0.0.0" });
    app.log.info(`IRIS Registry listening on ${env.baseUrl}`);
  } catch (error) {
    app.log.error({ err: error }, "Failed to start server");
    process.exit(1);
  }
};

void start();
