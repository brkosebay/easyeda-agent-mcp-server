/** Parse explicit physical values; never decode digits embedded in manufacturer part numbers. */
export function parsePhysicalValue(raw: string | undefined, expectedUnit: 'Ω' | 'F' | 'H', allowImplicit = false, allowBare = false): number | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const scales: Record<string, number> = {'':1,p:1e-12,P:1e-12,n:1e-9,N:1e-9,u:1e-6,U:1e-6,'µ':1e-6,'μ':1e-6,m:1e-3,k:1e3,K:1e3,M:1e6,G:1e9};
  const explicit = /(?:^|[\s_([{,:;])([0-9]+(?:\.[0-9]+)?)\s*([pPnNuUµμmkKMG]?)\s*(Ω|[oO][hH][mM][sS]?|[fF]|[hH])(?=$|[\s_\])},;:/+\-])/g;
  for (const match of raw.matchAll(explicit)) {
    const unit = /^(Ω|ohms?)$/i.test(match[3]) ? 'Ω' : match[3].toUpperCase();
    if (unit !== expectedUnit) continue;
    const value=Number(match[1])*scales[match[2]];
    if (Number.isFinite(value)) return value;
  }
  if (allowImplicit) {
    const match=raw.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([pPnNuUµμmkKMG]?)$/);
    if (match && (match[2] || allowBare)) { const value=Number(match[1])*scales[match[2]]; if(Number.isFinite(value)) return value; }
  }
  return undefined;
}
