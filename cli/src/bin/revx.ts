#!/usr/bin/env node
import { createProgram } from "../index.js";
import { handleError } from "../util/errors.js";

const program = createProgram();
program.parseAsync(process.argv).catch(handleError);
