#!/usr/bin/env node
/** Process entry (the esbuild bundle's entry point and `tsx src/bin.ts`). */
import { cli } from './main.ts';

void cli(process.argv.slice(2));
