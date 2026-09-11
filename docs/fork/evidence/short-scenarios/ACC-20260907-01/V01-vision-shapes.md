# V01 vision shapes and visible text

- Status: FAIL (image assignment and visual consumption passed; text recognition failed)
- Isolated chat session: `qvPBnEycPmJ0uUNjeIHX7`.
- Fixture: `workspace/V01-test/test-visual.svg`.
- Fixture content: white background, red circle, blue square, and the visible marker `ACC-20260907-01-V01`.

The chat UI exposed a hidden attached `input[type=file]` accepting `image/*`. The file was assigned through the UI upload path, rendered as the pending image, and then consumed by the model in the next chat turn. The assistant correctly described the white background, red circle, and blue square.

The assistant said that there was no text, although the SVG contained the visible run marker. The image was therefore consumed, but the required shape/color/text answer was incomplete. V01 is FAIL. No message or action was sent to the restored legacy session.
