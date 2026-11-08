import { m } from './i18n';
export function createAsyncActionState() {
  const state = $state({
    loading: false,
    message: '',
    error: ''
  });

  function clearFeedback() {
    state.message = '';
    state.error = '';
  }

  function setMessage(message) {
    state.message = message;
    state.error = '';
  }

  function setError(error) {
    state.error = error;
    state.message = '';
  }

  async function run(action, {
    successMessage = '',
    failureMessage = m.aax_failed()
  } = {}) {
    state.loading = true;
    clearFeedback();

    try {
      const ok = await action();
      if (ok) {
        if (successMessage) setMessage(successMessage);
        return true;
      }

      if (failureMessage) setError(failureMessage);
      return false;
    } catch (error) {
      console.error('Async action failed:', error);
      if (error instanceof Error && error.message) {
        setError(error.message);
      } else if (failureMessage) {
        setError(failureMessage);
      }
      return false;
    } finally {
      state.loading = false;
    }
  }

  return {
    state,
    run,
    clearFeedback,
    setMessage,
    setError
  };
}
