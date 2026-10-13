/** Only these fixed diagnostics may cross the native-agent HTTP boundary. */
const reasons = {
  DEFAULT_FOLDER_UNTRUSTED: "Choose and trust a default folder in setup before creating a chat.",
  PROJECT_FOLDER_UNTRUSTED: "Select and trust this project's exact folder before starting a turn.",
  PROJECT_FOLDER_UNAVAILABLE:
    "The trusted project folder changed or is unavailable; select and trust it again.",
  MODEL_NOT_CONFIGURED:
    "Select a configured inference model. Account models require a connected account.",
} as const;

export class RuntimeCodingPreflightError extends Error {
  constructor(
    readonly code: keyof typeof reasons,
    message: string = reasons[code],
  ) {
    super(message);
    this.name = "RuntimeCodingPreflightError";
  }

  publicDiagnostic() {
    return { code: this.code, reason: reasons[this.code] };
  }
}
