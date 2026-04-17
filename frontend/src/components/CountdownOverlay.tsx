import { useRoomStore } from '../store/room-store';

export default function CountdownOverlay() {
  const { countdownSeconds } = useRoomStore();

  if (!countdownSeconds || countdownSeconds <= 0) {
    return null;
  }

  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center">
      <div className="text-center">
        <div className="text-6xl font-bold text-white mb-4">Everyone voted!</div>
        <div className="text-2xl text-gray-200 mb-8">Revealing in {countdownSeconds}...</div>
        <div className="flex justify-center">
          <div className="w-24 h-24 rounded-full border-4 border-primary-500 flex items-center justify-center">
            <div className="text-4xl font-bold text-primary-500">{countdownSeconds}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
