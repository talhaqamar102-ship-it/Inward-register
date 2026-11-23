import { showToast } from './domModalsAndPrint';

/** Bind paired Good + Defects number inputs so their sum stays equal to `available`. */
export function bindComplementaryStageInputs(goodInputId: string, defectInputId: string, available: number): void {
  const goodInput = document.getElementById(goodInputId) as HTMLInputElement | null;
  const defectInput = document.getElementById(defectInputId) as HTMLInputElement | null;
  if (!goodInput || !defectInput) return;

  goodInput.min = defectInput.min = '0';
  goodInput.max = defectInput.max = String(available);
  goodInput.value = String(available);
  defectInput.value = '0';

  goodInput.addEventListener('input', () => {
    const good = Math.min(available, Math.max(0, Number(goodInput.value) || 0));
    goodInput.value = String(good);
    defectInput.value = String(available - good);
  });
  defectInput.addEventListener('input', () => {
    const defects = Math.min(available, Math.max(0, Number(defectInput.value) || 0));
    defectInput.value = String(defects);
    goodInput.value = String(available - defects);
  });
}

/** Validate and read paired Good + Defects inputs against stage available pairs. */
export function readComplementaryStageInputs(goodInputId: string, defectInputId: string, available: number): { good: number; defects: number } | null {
  const good = Number((document.getElementById(goodInputId) as HTMLInputElement | null)?.value);
  const defects = Number((document.getElementById(defectInputId) as HTMLInputElement | null)?.value);
  if (
    !Number.isInteger(good) || !Number.isInteger(defects) ||
    good < 0 || defects < 0 || good + defects !== available
  ) {
    showToast(`Passed and defect pairs must total the ${available} pairs available in this stage.`);
    return null;
  }
  return { good, defects };
}

/** Return unprocessed pairs remaining in a stage after accounting for passed and defective pairs. */
export function remainingStagePairs(input: number, passed: number, defects: number): number {
  return Math.max(0, Number(input || 0) - Number(passed || 0) - Number(defects || 0));
}
