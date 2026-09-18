import { createClient } from 'redis';
import { env } from './environment.js';
import { logger } from '../utils/logger.js';

export const redisClient = createClient({
    url: env.REDIS_URL,
});

redisClient.on('error', (error) => {
    logger.error({ err: error }, 'Redis client error');
})

export const connectRedis = async (): Promise<void> => {
    if(!redisClient.isOpen) {
        await redisClient.connect();
        logger.info('Secure in-memory Redis engine connected.');
    }
}
