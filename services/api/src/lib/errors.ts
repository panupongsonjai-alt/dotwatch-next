export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const unauthorized = (message = "Sign in again.") => new HttpError(401, "unauthorized", message);
export const forbidden = (message = "Your role in this organization does not allow this.") =>
  new HttpError(403, "forbidden", message);
export const notFound = (message = "Not found.") => new HttpError(404, "not_found", message);
