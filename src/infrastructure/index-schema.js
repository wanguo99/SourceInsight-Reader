'use strict';
// Shared by both producer workers; changing parser semantics invalidates local
// facts without discarding observations from the language service.
const PARSER_ID = require('../../vendor/tree-sitter/manifest.json').map(asset => asset.sha256).join(':') + ':facts-18';
module.exports = { PARSER_ID };
