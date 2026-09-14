import os
from unittest import TestCase
from unittest.mock import Mock, patch

from tome_agent import tracing


class TracingConfigurationTest(TestCase):
    def setUp(self) -> None:
        tracing._client = None
        tracing._instrumented = False

    def tearDown(self) -> None:
        tracing._client = None
        tracing._instrumented = False

    def test_missing_credentials_keeps_tracing_disabled(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            tracing.initialize_tracing()

        self.assertFalse(tracing.tracing_enabled())

    def test_explicit_disable_wins_over_complete_configuration(self) -> None:
        env = {
            "LANGFUSE_PUBLIC_KEY": "pk-test",
            "LANGFUSE_SECRET_KEY": "sk-test",
            "LANGFUSE_BASE_URL": "https://langfuse.example.test",
            "LANGFUSE_TRACING_ENABLED": "false",
        }
        with patch.dict(os.environ, env, clear=True):
            tracing.initialize_tracing()

        self.assertFalse(tracing.tracing_enabled())

    @patch("openinference.instrumentation.claude_agent_sdk.ClaudeAgentSDKInstrumentor")
    @patch("langfuse.get_client")
    def test_complete_configuration_instruments_sdk_and_flushes(
        self,
        get_client: Mock,
        instrumentor_class: Mock,
    ) -> None:
        client = Mock()
        get_client.return_value = client
        env = {
            "LANGFUSE_PUBLIC_KEY": "pk-test",
            "LANGFUSE_SECRET_KEY": "sk-test",
            "LANGFUSE_BASE_URL": "https://langfuse.example.test",
        }
        with patch.dict(os.environ, env, clear=True):
            tracing.initialize_tracing()
            tracing.flush_tracing()

        self.assertTrue(tracing.tracing_enabled())
        get_client.assert_called_once_with()
        instrumentor_class.return_value.instrument.assert_called_once_with()
        client.flush.assert_called_once_with()
