import { createClient } from 'redis';
import { env } from './environment.js';

export const redisClient = createClient({
    url: env.REDIS_URL,
});

redisClient.on('error', (error) => {
    console.error('Redis Client Error', error);
})

export const connectRedis = async (): Promise<void> => {
    if(!redisClient.isOpen) {
        await redisClient.connect();
        console.log('Secure In-Memory Redis Engine Connected.')
    }
}