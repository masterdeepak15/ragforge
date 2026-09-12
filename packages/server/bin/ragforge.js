#!/usr/bin/env node

import { startServer } from '../dist/index.js';

startServer().catch(console.error);