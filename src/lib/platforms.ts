// The platforms a project can be filed under (the `platform` key of docusystem.config.json). It is
// the one list: the type, the schema's enum (config.schema.json), the validator and the help text
// all derive from it or are tested against it.
export const PLATFORMS = ["frappe", "odoo", "wordpress", "nixos", "general"] as const;

export type Platform = (typeof PLATFORMS)[number];
