export class EnquiryDomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'EnquiryDomainError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PrimaryConversationConflictError extends EnquiryDomainError {
  constructor(inquiryId: string, activeConvId: string) {
    super(
      `Inquiry ${inquiryId} already has an active primary conversation (${activeConvId})`,
      'PRIMARY_CONV_CONFLICT',
      { inquiryId, activeConvId }
    );
    this.name = 'PrimaryConversationConflictError';
  }
}

export class RequestValidationError extends EnquiryDomainError {
  constructor(field: string, reason: string) {
    super(
      `Request validation failed on '${field}': ${reason}`,
      'VALIDATION_FAILED',
      { field, reason }
    );
    this.name = 'RequestValidationError';
  }
}

export class ActorSecurityError extends EnquiryDomainError {
  constructor(reason: string) {
    super(
      `Actor security violation: ${reason}`,
      'ACTOR_SECURITY_VIOLATION',
      { reason }
    );
    this.name = 'ActorSecurityError';
  }
}

export class MessageImmutabilityError extends EnquiryDomainError {
  constructor(message: string) {
    super(
      message,
      'MESSAGE_IMMUTABLE'
    );
    this.name = 'MessageImmutabilityError';
  }
}
