import { createLocalAuth } from '@masters/auth';
import { db } from './db';

export const auth = createLocalAuth(db);
