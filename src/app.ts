import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import pinoHttp from 'pino-http';
import client from 'prom-client';
import { errorHandler } from './middlewares/error.middleware.js';
import { catchAsync } from './middlewares/catchAsync.js';
import { metricsMiddleware } from './middlewares/metrics.middleware.js';
import { traceMiddleware, getCorrelationId } from './middlewares/trace.middleware.js';
import { logger } from './utils/logger.js';
import authRoutes from "./modules/auth/auth.routes.js";
import orderRoutes from "./modules/orders/order.routes.js";
import trackingRoutes from "./modules/tracking/tracking.routes.js";

const openapiDocument = YAML.load('src/docs/openapi.yaml');

export const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 100 }))
app.use(traceMiddleware);
app.use(pinoHttp({
  logger,
  genReqId: () => getCorrelationId(),
}));
app.use(metricsMiddleware);

app.get('/health', (_request, response) => {
    response.status(200).json({ status: 'ok' })
});

app.get('/metrics', catchAsync(async (_request, response) => {
    response.setHeader('Content-Type', client.register.contentType);
    response.send(await client.register.metrics());
}));

app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapiDocument));
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/orders', orderRoutes);
app.use('/api/v1/tracking', trackingRoutes);
app.use(errorHandler);

export default app;
