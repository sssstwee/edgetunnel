import bundledPolicy from './clash-base.yaml';
import { createJmsWorker } from './worker.mjs';

export default createJmsWorker(bundledPolicy);
