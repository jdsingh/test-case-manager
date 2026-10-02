// Where the PAT lives (PRD section 8): localStorage by default so it survives restarts,
// or sessionStorage when the user ticks "Forget when this tab closes".

const KEY = 'tcm.token';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class TokenStore {
  constructor(
    private readonly local: StorageLike,
    private readonly session: StorageLike,
  ) {}

  get(): string | null {
    return this.session.getItem(KEY) ?? this.local.getItem(KEY);
  }

  set(token: string, forgetOnClose: boolean): void {
    this.clear();
    (forgetOnClose ? this.session : this.local).setItem(KEY, token);
  }

  clear(): void {
    this.local.removeItem(KEY);
    this.session.removeItem(KEY);
  }
}
