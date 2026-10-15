#!/usr/bin/env bun
import { runCLI } from "./app/cli";

if (import.meta.main) await runCLI(Bun.argv.slice(2));
