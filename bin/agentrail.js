#!/usr/bin/env node
// Thin shim — npm rejects .ts bin entries.
// Requires Node 24+ which strips TypeScript types natively.
import '../src/cli/index.ts';
