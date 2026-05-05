import unittest


from agentrail import TaskSubmitRequest


class TaskSubmitContractTest(unittest.TestCase):
    def test_adapter_managed_submit_serializes_without_artifacts(self) -> None:
        request = TaskSubmitRequest(
            summary="Implemented the assigned task and pushed commits to the task branch.",
            mode="adapter_managed",
            pullRequest={"title": "Fix adapter-managed submit contract", "draft": False},
        )

        self.assertEqual(
            request.model_dump(by_alias=True, exclude_none=True),
            {
                "summary": "Implemented the assigned task and pushed commits to the task branch.",
                "mode": "adapter_managed",
                "pullRequest": {
                    "title": "Fix adapter-managed submit contract",
                    "draft": False,
                },
            },
        )

    def test_artifact_demo_submit_remains_supported(self) -> None:
        request = TaskSubmitRequest(
            summary="Submitted deterministic local demo artifact.",
            mode="artifact",
            artifacts=[
                {
                    "type": "pull_request",
                    "url": "https://github.com/oxnw/agentrail/pull/42",
                }
            ],
        )

        self.assertEqual(
            request.model_dump(by_alias=True, exclude_none=True)["artifacts"],
            [
                {
                    "type": "pull_request",
                    "url": "https://github.com/oxnw/agentrail/pull/42",
                }
            ],
        )


if __name__ == "__main__":
    unittest.main()
