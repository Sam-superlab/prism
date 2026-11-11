export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export const notFound = () => new ApiError(404, 'NOT_FOUND', 'Record not found');
export const validation = (message: string, details: Record<string, unknown> = {}) =>
  new ApiError(422, 'VALIDATION_ERROR', message, details);
