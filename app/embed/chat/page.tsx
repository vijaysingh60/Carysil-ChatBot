/**
 * Embeddable chatbot page, loaded in an iframe by the official site (carysil.com's ChatLauncher).
 * The host page owns the launcher button and the frame's size, position and rounded corners; the
 * chat panel fills the frame and asks the host to close it via postMessage ("carysil-chat:close").
 * Recommended frame size: ~400×640 on desktop, the visible viewport on phones.
 */
export default function EmbedChatPage() {
  return (
    <>
      <style>{`html,body{background:transparent!important;overflow:hidden}`}</style>
      <div aria-hidden className="h-screen w-full" />
    </>
  );
}
