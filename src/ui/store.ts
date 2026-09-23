/**
 * 最小限の状態コンテナ。
 *
 * フレームワークを入れずに済ませるため、「状態は 1 か所」「変更は set 経由」「描画は購読者が行う」
 * だけを守る。パネル同士は直接呼び合わず、必ずこの store を介して連動する。
 * そうしておけば「クリック → 何が変わる → どのパネルが反応する」を store の変更として追える。
 */
export interface Store<S> {
  get(): S;
  set(patch: Partial<S>): void;
  subscribe(listener: (state: S, prev: S) => void): () => void;
}

export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<(state: S, prev: S) => void>();
  return {
    get: () => state,
    set(patch) {
      const prev = state;
      state = { ...state, ...patch };
      for (const l of listeners) l(state, prev);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
