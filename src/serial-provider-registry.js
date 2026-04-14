let defaultSerialProvider = null;

export function setDefaultSerialProvider(provider) {
  defaultSerialProvider = provider;
}

export function getDefaultSerialProvider() {
  return defaultSerialProvider;
}
