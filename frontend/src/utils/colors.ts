const GOLDEN_ANGLE = 137.508;

function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function seedToColor(seed: string): string {
  const hash = hashString(seed);
  const hue = (hash * GOLDEN_ANGLE) % 360;
  return `hsl(${hue}, 55%, 50%)`;
}
