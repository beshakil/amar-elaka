/**
 * Base for all typed domain exceptions. The global exception filter maps
 * these to HTTP responses using `code` and `httpStatus` and never exposes
 * anything beyond `message` — business modules should keep messages safe
 * for clients and put diagnostic detail in the logged error instead.
 */
export abstract class DomainException extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}
