/**
 * Embeddable chatbot page for iframe on the official site.
 * Use: <iframe src="https://your-domain.com/embed/chat" title="Carysil Concierge" />
 * Recommended iframe size: 400×600 or 420×640 for a compact corner widget.
 */
export default function EmbedChatPage() {
  return (
    <div
      className="min-h-screen w-full bg-transparent"
      style={{ minHeight: "100vh" }}
      aria-hidden
    />
  );
}
