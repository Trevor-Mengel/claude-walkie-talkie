#!/usr/bin/env node
// bin/walkie.js
import { run } from '../src/cli/index.js';

process.exitCode = await run(process.argv);
