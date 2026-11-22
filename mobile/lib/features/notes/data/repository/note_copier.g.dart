// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'note_copier.dart';

// **************************************************************************
// RiverpodGenerator
// **************************************************************************

// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, type=warning

@ProviderFor(noteCopier)
final noteCopierProvider = NoteCopierProvider._();

final class NoteCopierProvider
    extends $FunctionalProvider<NoteCopier, NoteCopier, NoteCopier>
    with $Provider<NoteCopier> {
  NoteCopierProvider._()
    : super(
        from: null,
        argument: null,
        retry: null,
        name: r'noteCopierProvider',
        isAutoDispose: false,
        dependencies: null,
        $allTransitiveDependencies: null,
      );

  @override
  String debugGetCreateSourceHash() => _$noteCopierHash();

  @$internal
  @override
  $ProviderElement<NoteCopier> $createElement($ProviderPointer pointer) =>
      $ProviderElement(pointer);

  @override
  NoteCopier create(Ref ref) {
    return noteCopier(ref);
  }

  /// {@macro riverpod.override_with_value}
  Override overrideWithValue(NoteCopier value) {
    return $ProviderOverride(
      origin: this,
      providerOverride: $SyncValueProvider<NoteCopier>(value),
    );
  }
}

String _$noteCopierHash() => r'8a57a2ba1b2943642964ff4776fded81ba8c6679';
