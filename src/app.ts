import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import { errorHandler } from './middlewares/error.middleware.js';
import authRoutes from "./modules/auth/auth.routes.js";

const openapiDocument = YAML.load('src/docs/openapi.yaml');

export const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 100 }))

app.get('/health', (_request, response) => {
    response.status(200).json({ status: 'ok' })
});

app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapiDocument));
app.use('/api/v1/auth', authRoutes);
app.use(errorHandler);

export default app;