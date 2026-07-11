export type RegressionInvariant = () => void | Promise<void>;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Records a confirmed defect without making the default suite red.
 *
 * The invariant must describe the desired fixed behavior. While the defect is
 * present it throws and is reported as an expected failure. Once the invariant
 * passes, this helper deliberately fails so the fixing pull request must promote
 * the case to a normal regression test instead of silently retaining an xfail.
 */
export async function expectKnownRegression(
  name: string,
  invariant: RegressionInvariant,
): Promise<void> {
  try {
    await invariant();
  } catch (error) {
    console.log(`  xfail ${name}: ${errorMessage(error)}`);
    return;
  }

  throw new Error(
    `known regression '${name}' now passes; convert it to a normal regression test and remove expectKnownRegression`,
  );
}
