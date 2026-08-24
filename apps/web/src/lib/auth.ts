import { createLocalAuth } from '@masters/auth';
import { db, dbEngine } from './db';

export const auth = createLocalAuth(db, dbEngine);
