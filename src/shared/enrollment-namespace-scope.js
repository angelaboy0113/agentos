// Trusted project settings, never model-selected fallbacks or "all" when a name is missing.
export function configuredNamespaceScope(configured, available) {
 if (configured == null) return null;
 if (!Array.isArray(configured) || !configured.length || !Array.isArray(available)
  || configured.some(ns => typeof ns !== 'string' || !available.some(x => x.namespace === ns))) throw Error('Configured namespace scope does not match this Nacos');
 return [...new Set(configured)];
}
