import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../tokens/app_radii.dart';

/// Hand-rolled 6-box OTP input — six digit boxes, auto-advance on entry,
/// backspace-to-previous when empty, and paste support (pasting a full code
/// into any box distributes it across the remaining boxes from that point).
/// Deliberately not a package: this is the one input shape the app needs,
/// not worth a dependency.
class OtpCodeInput extends StatefulWidget {
  const OtpCodeInput({
    required this.length,
    required this.onCompleted,
    super.key,
    this.hasError = false,
  });

  final int length;
  final bool hasError;
  final ValueChanged<String> onCompleted;

  @override
  State<OtpCodeInput> createState() => _OtpCodeInputState();
}

class _OtpCodeInputState extends State<OtpCodeInput> {
  late final _controllers = List.generate(
    widget.length,
    (_) => TextEditingController(),
  );
  late final _focusNodes = List.generate(widget.length, (_) => FocusNode());

  @override
  void dispose() {
    for (final controller in _controllers) {
      controller.dispose();
    }
    for (final node in _focusNodes) {
      node.dispose();
    }
    super.dispose();
  }

  void _onChanged(int index, String value) {
    final digitsOnly = value.replaceAll(RegExp(r'\D'), '');

    if (digitsOnly.length > 1) {
      // A paste landed in one box — distribute it across this box and the
      // ones after it.
      _distribute(index, digitsOnly);
      return;
    }

    _controllers[index].text = digitsOnly;
    if (digitsOnly.isEmpty) return;

    if (index < widget.length - 1) {
      _focusNodes[index + 1].requestFocus();
    } else {
      _focusNodes[index].unfocus();
    }
    _checkCompleted();
  }

  void _distribute(int startIndex, String digits) {
    var cursor = startIndex;
    for (final digit in digits.split('')) {
      if (cursor >= widget.length) break;
      _controllers[cursor].text = digit;
      cursor++;
    }
    final nextEmpty = cursor.clamp(0, widget.length - 1);
    _focusNodes[nextEmpty].requestFocus();
    _checkCompleted();
  }

  void _onBackspace(int index) {
    if (_controllers[index].text.isNotEmpty) return;
    if (index == 0) return;
    _focusNodes[index - 1].requestFocus();
    _controllers[index - 1].text = '';
  }

  void _checkCompleted() {
    final code = _controllers.map((c) => c.text).join();
    if (code.length == widget.length) widget.onCompleted(code);
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        for (var i = 0; i < widget.length; i++)
          SizedBox(
            width: 44,
            height: 52,
            child: KeyboardListener(
              focusNode: FocusNode(skipTraversal: true),
              onKeyEvent: (event) {
                if (event is KeyDownEvent &&
                    event.logicalKey == LogicalKeyboardKey.backspace) {
                  _onBackspace(i);
                }
              },
              child: TextField(
                controller: _controllers[i],
                focusNode: _focusNodes[i],
                autofocus: i == 0,
                textAlign: TextAlign.center,
                keyboardType: TextInputType.number,
                maxLength: widget.length,
                style: Theme.of(context).textTheme.headlineMedium,
                decoration: InputDecoration(
                  counterText: '',
                  contentPadding: EdgeInsets.zero,
                  filled: true,
                  fillColor: colors.surfaceContainerHighest,
                  border: OutlineInputBorder(
                    borderRadius: AppRadii.mdRadius,
                    borderSide: widget.hasError
                        ? BorderSide(color: colors.error)
                        : BorderSide.none,
                  ),
                ),
                onChanged: (value) => _onChanged(i, value),
              ),
            ),
          ),
      ],
    );
  }
}
