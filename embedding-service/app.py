from flask import Flask, jsonify, request
from sentence_transformers import SentenceTransformer

app = Flask(__name__)
model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")


@app.post("/embed")
def embed() -> tuple:
    payload = request.get_json(silent=True) or {}
    text = str(payload.get("text", "")).strip()
    if not text:
        return jsonify({"error": "text is required"}), 400

    embedding = model.encode(text, normalize_embeddings=True).tolist()
    return jsonify({"embedding": embedding}), 200


@app.get("/health")
def health() -> tuple:
    return jsonify({"status": "ok", "model": "all-MiniLM-L6-v2"}), 200


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001)
