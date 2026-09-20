/**
 * The two refusal classes every Knowledge Ledger module shares.
 *
 * They live here, rather than in `kernel.ts`, so that modules the kernel
 * itself depends on (`scope.ts`) can refuse in the same vocabulary without an
 * import cycle. `kernel.ts` re-exports both, so every existing importer is
 * unchanged.
 */

/** An input or transition the ledger refuses: bad shape, an unknown reference,
 *  a duplicate id, a cycle, a scope boundary. Maps to 400. */
export class KnowledgeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeValidationError";
  }
}

/** A lookup of a claim (or revision) that does not exist. Maps to 404. */
export class UnknownClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownClaimError";
  }
}
