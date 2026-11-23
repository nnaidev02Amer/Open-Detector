import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture(scope="session")
def detector():
    from detector import get_detector
    return get_detector()


AI_TEXT = (
    "In conclusion, the integration of artificial intelligence into modern educational frameworks presents both "
    "significant opportunities and notable challenges that warrant careful consideration by stakeholders. "
    "Furthermore, it is essential to recognize that the effective implementation of such technologies requires a "
    "comprehensive and multifaceted approach. Moreover, policymakers must ensure that equitable access is "
    "maintained across diverse socioeconomic contexts."
)
HUMAN_TEXT = (
    "we ran the thing three times and honestly the third run was weird, loss went up after epoch 4 and i have no "
    "idea why. maybe the lr? i tried halving it but then it just crawled. my labmate thinks the data loader was "
    "shuffling wrong, which, ok, possible, but i checked twice and it looked fine to me."
)
