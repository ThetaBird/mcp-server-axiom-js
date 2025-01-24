#!/usr/bin/env node

const path = require("path");
const fs = require("fs");

// Check for config file
const configFile = process.argv[2];
if (configFile) {
  try {
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    for (const [key, value] of Object.entries(config)) {
      process.env[`AXIOM_${key.toUpperCase()}`] = value.toString();
    }
  } catch (error) {
    console.error(`Error reading config file: ${error.message}`);
    process.exit(1);
  }
}

// Run the server
require("../index.js");
