export type RegressionInvariant = () => void | Promise<void>;

export class KnownRegressionObserved extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnownRegressionObserved";
  }
}

/** Mark the precise point where a confirmed defect is still observable. */
export function regressionStillPresent(message: string): never {
  throw new KnownRegressionObserved(message);
}

/**
 * Records a confirmed defect without making the default suite red.
 *
 * The invariant must describe the desired fixed behavior and call
 * `regressionStillPresent` only when that specific defect is observed. Other
 * exceptions are treated as real test failures. Once the invariant passes,
 * this helper deliberately fails so the fixing pull request must promote the
 * case to a normal regression test instead of silently retaining an xfail.
 */
export async function expectKnownRegression(
  name: string,
  invariant: RegressionInvariant,
): Promise<void> {
  try {
    await invariant();
  } catch (error) {
    if (!(error instanceof KnownRegressionObserved)) throw error;
    console.log(`  xfail ${name}: ${error.message}`);
    return;
  }

  throw new Error(
    `known regression '${name}' now passes; convert it to a normal regression test and remove expectKnownRegression`,
  );
}
