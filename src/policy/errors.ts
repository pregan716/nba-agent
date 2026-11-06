/** Only these failures describe the package rather than the execution harness. */
export class PackageExecutionError extends Error {
  constructor(
    message: string,
    readonly windowOnly = false,
  ) {
    super(message);
  }
}
/** The environment cannot encode this state in the fixed provider contract. */
export class UnsupportedDecisionState extends PackageExecutionError {
  constructor(message: string) {
    super(message, true);
  }
}

export class AssemblerInfrastructureError extends Error {}
