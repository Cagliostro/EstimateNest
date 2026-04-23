import { seedToColor } from '../utils/colors';

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0].toUpperCase();
  if (parts.length === 1) return first;
  const last = parts[parts.length - 1][0].toUpperCase();
  return first + last;
}

const SIZE_MAP = {
  sm: { size: 32, fontSize: '0.75rem' },
  md: { size: 40, fontSize: '0.875rem' },
  lg: { size: 48, fontSize: '1rem' },
} as const;

interface AvatarProps {
  seed: string;
  name: string;
  size?: keyof typeof SIZE_MAP;
  className?: string;
}

export default function Avatar({ seed, name, size = 'md', className = '' }: AvatarProps) {
  const dims = SIZE_MAP[size];
  const bgColor = seedToColor(seed);
  const initials = getInitials(name);

  return (
    <div
      className={`inline-flex items-center justify-center rounded-full text-white font-bold select-none shrink-0 ${className}`}
      style={{
        width: dims.size,
        height: dims.size,
        backgroundColor: bgColor,
        fontSize: dims.fontSize,
      }}
      title={name}
    >
      {initials}
    </div>
  );
}
