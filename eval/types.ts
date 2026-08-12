export type EvalCategory =
  | "product_lookup_name"
  | "product_lookup_id"
  | "attribute_dimension"
  | "attribute_material"
  | "attribute_price"
  | "attribute_installation"
  | "attribute_color"
  | "semantic_paraphrase"
  | "semantic_typo"
  | "filtering"
  | "comparison"
  | "multi_hop"
  | "follow_up"
  | "no_answer"
  | "out_of_domain"
  | "adversarial_injection";

export type Difficulty = "easy" | "medium" | "hard";

export type GoldenCase = {
  id: string;
  question: string;
  /** Ground truth pulled directly from the products table — never fabricated. */
  expected_answer: string | null;
  /** Product/document ids that should appear in top-K retrieval for this query. */
  expected_sources: string[];
  category: EvalCategory;
  difficulty: Difficulty;
  /** False for no_answer / out_of_domain cases where the correct behavior is to say "I don't know". */
  should_have_answer: boolean;
  /** Optional structured filter expectations used by the retrieval harness. */
  meta?: Record<string, unknown>;
};

export type ConversationTurn = {
  message: string;
  /** What the follow-up turn's retrieval/answer must correctly resolve (e.g. pronoun target). */
  expected_reference?: string;
  expected_sources?: string[];
};

export type ConversationCase = {
  id: string;
  description: string;
  turns: ConversationTurn[];
};
